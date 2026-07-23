import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  EngineKind,
  OpenAIProtocol,
  Provider,
  ProviderApiKey,
  ProviderApiKeyInput,
  ProviderApiKeyUpdateInput,
  ProviderInput,
  ProviderModelFetchInput,
  ProviderModelFetchResult,
  ProviderView
} from '../shared/types'
import { recordFailure, recordSuccess } from './scheduler'
import { pickNextProviderKey } from './providerKeyRouting'
import {
  inspectProviderBaseUrl,
  inspectProviderCustomHeaders,
  isAllowedProviderManagedCredentialHeaderName,
  ProviderCredentialBroker,
  type CredentialStorageState
} from './providerCredentialBroker'
import { validateProviderCredentialInput } from './provider/credentialInput'
import {
  migrateProviderCredentials,
  sanitizeProviderCredentialsForRuntime
} from './provider/credentialMigration'
import { bindProviderModelDiscoveryInput } from './provider/modelDiscoveryBinding'
import { discoverProviderModels, parseProviderHeaderLines } from './provider/modelDiscovery'
import { mergeProviderPatch, removeProviderKeys, resolveProviderPatchFields } from './provider/providerUpdate'

let cache: Provider[] | null = null
const credentialBroker = new ProviderCredentialBroker(safeStorage)

function providersFile(): string {
  return join(app.getPath('userData'), 'providers.json')
}

function load(): Provider[] {
  if (cache) return cache
  const file = providersFile()
  const firstRun = !existsSync(file)
  if (!firstRun && process.platform !== 'win32') chmodSync(file, 0o600)
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    cache = Array.isArray(raw) ? (raw as Provider[]) : []
  } catch {
    cache = []
    if (firstRun) persist()
  }
  if (cache.length > 0) {
    const loadedProviders = cache
    const migration = migrateLoadedProviders(loadedProviders)
    cache = migration.providers
    if (migration.changed) {
      try {
        persist()
      } catch (err) {
        // 保持与磁盘凭据状态一致，同时继续阻断历史 Header/Base URL 凭据进入运行时和 Renderer。
        cache = sanitizeLoadedProvidersForRuntime(loadedProviders)
        console.error('[agent-desk] Provider 凭据迁移写回失败:', err)
      }
    }
  }
  return cache
}

function persist(): void {
  const file = providersFile()
  const directory = dirname(file)
  const tempFile = join(directory, `.providers.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    mkdirSync(directory, { recursive: true })
    descriptor = openSync(tempFile, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(persistedProviders(cache ?? []), null, 2)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(tempFile, file)
    if (process.platform !== 'win32') {
      try {
        // rename 保留以 0600 创建的临时文件模式；这里仅防御性再次收紧。
        chmodSync(file, 0o600)
      } catch (err) {
        console.error('[agent-desk] Provider 文件权限复核失败:', err)
      }
    }
  } catch (err) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {
        // best effort
      }
    }
    if (existsSync(tempFile)) {
      try {
        unlinkSync(tempFile)
      } catch {
        // best effort
      }
    }
    throw err
  }
}

function persistedProviders(providers: Provider[]): Provider[] {
  return providers.map((provider) => {
    const apiKeys = normalizedProviderKeys(provider)
      .filter((key) => key.sessionOnly !== true && Boolean(key.encryptedToken))
      .map(({ sessionOnly: _sessionOnly, ...key }) => key)
    const activeKey = apiKeys.find((key) => key.id === provider.activeKeyId && !key.disabled)
      ?? apiKeys.find((key) => !key.disabled)
    const legacyActiveToken = activeKey?.encryptedToken.startsWith('b64:') === true
      ? ''
      : activeKey?.encryptedToken ?? ''
    const safeHeaders = inspectProviderCustomHeaders(provider.customHeaders ?? '').safeValue.trim()
    const safeBaseUrl = inspectProviderBaseUrl(provider.baseUrl).safeValue
    const managedCredentialHeaders = inspectCredentialHeaderNames(provider.credentialHeaderNames).names
    return {
      ...provider,
      baseUrl: safeBaseUrl,
      customHeaders: safeHeaders || undefined,
      credentialHeaderNames: managedCredentialHeaders.length > 0 ? managedCredentialHeaders : undefined,
      // 旧 b64 只保留 apiKeys 中的一份，避免持久化时再生成可逆镜像。
      encryptedToken: legacyActiveToken,
      apiKeys,
      activeKeyId: activeKey?.id
    }
  })
}

function migrateLoadedProviders(providers: Provider[]): { providers: Provider[]; changed: boolean } {
  return migrateProviderCredentials(providers, {
    inspectCredentialHeaderNames,
    legacyKeyId,
    migrateLegacy: (ref, encryptedToken) => credentialBroker.migrateLegacy(ref, encryptedToken),
    migrationMarker: { credentialMigrationRequired: true }
  })
}

function sanitizeLoadedProvidersForRuntime(providers: Provider[]): Provider[] {
  return sanitizeProviderCredentialsForRuntime(providers, {
    inspectCredentialHeaderNames,
    migrationMarker: { credentialMigrationRequired: true }
  })
}

function normalizedCustomHeaders(value: string | undefined): string | undefined {
  const inspected = inspectProviderCustomHeaders(value ?? '')
  if (inspected.rejectedNames.length > 0) {
    throw new Error(`自定义请求头只允许非敏感路由元数据字段;已拒绝: ${inspected.rejectedNames.join(', ')}。凭据请使用 API 密钥字段。`)
  }
  return inspected.safeValue.trim() || undefined
}

const BLOCKED_MANAGED_CREDENTIAL_HEADERS = new Set([
  'connection',
  'content-length',
  'cookie',
  'host',
  'proxy-authorization',
  'set-cookie',
  'transfer-encoding'
])
const HTTP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

function inspectCredentialHeaderNames(value: unknown): { names: string[]; rejected: string[] } {
  if (value === undefined) return { names: [], rejected: [] }
  if (!Array.isArray(value)) return { names: [], rejected: ['credentialHeaderNames'] }
  const names: string[] = []
  const rejected: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') {
      rejected.push('(non-string header name)')
      continue
    }
    const name = item.trim()
    const normalized = name.toLowerCase()
    if (
      !name
      || name.length > 80
      || !HTTP_HEADER_NAME.test(name)
      || BLOCKED_MANAGED_CREDENTIAL_HEADERS.has(normalized)
      || !isAllowedProviderManagedCredentialHeaderName(name)
    ) {
      rejected.push('(unsupported or invalid header name)')
      continue
    }
    if (seen.has(normalized)) continue
    if (names.length >= 8) {
      rejected.push(name)
      continue
    }
    seen.add(normalized)
    names.push(normalized)
  }
  return { names, rejected }
}

function normalizedCredentialHeaderNames(value: unknown): string[] | undefined {
  const inspected = inspectCredentialHeaderNames(value)
  if (inspected.rejected.length > 0) {
    throw new Error(`受管凭据头名称无效或不安全: ${inspected.rejected.join(', ')}`)
  }
  return inspected.names.length > 0 ? inspected.names : undefined
}

export function providerCredentialHeaders(
  provider: Pick<Provider, 'credentialHeaderNames'> | undefined,
  token: string
): Record<string, string> {
  if (!token) return {}
  const { names } = inspectCredentialHeaderNames(provider?.credentialHeaderNames)
  return Object.fromEntries(names.map((name) => [
    name,
    name.toLowerCase() === 'authorization' ? `Bearer ${token}` : token
  ]))
}

export function providerCredentialHeaderLines(
  provider: Pick<Provider, 'credentialHeaderNames'> | undefined,
  token: string
): string {
  return Object.entries(providerCredentialHeaders(provider, token))
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')
}

function assertProviderCredentialInput(input: Partial<ProviderInput>): void {
  validateProviderCredentialInput(input)
}

/** 加密串 → 明文 token,仅在主进程注入 SDK env 时使用,不回传渲染进程 */
export function decryptToken(encrypted: string): string {
  return credentialBroker.resolve(
    { providerId: '__legacy__', keyId: '__legacy__' },
    { encryptedToken: encrypted }
  ).token
}

const LEGACY_KEY_LABEL = '主密钥'

function legacyKeyId(providerId: string): string {
  return `${providerId}:legacy-primary`
}

function cleanKeyLabel(value: string | undefined, fallback: string): string {
  const label = value?.trim()
  return label || fallback
}

function createApiKey(providerId: string, input: ProviderApiKeyInput, fallbackLabel: string): ProviderApiKey | null {
  const token = input.token.trim()
  if (!token) return null
  const id = randomUUID()
  const credential = credentialBroker.store({ providerId, keyId: id }, token)
  return {
    id,
    label: cleanKeyLabel(input.label, fallbackLabel),
    encryptedToken: credential.encryptedToken,
    sessionOnly: credential.sessionOnly,
    createdAt: Date.now(),
    disabled: input.disabled === true
  }
}

function hasProviderKeyRecord(value: unknown): value is ProviderApiKey {
  return Boolean(value) && typeof (value as ProviderApiKey).encryptedToken === 'string'
}

function normalizedProviderKeys(provider: Provider): ProviderApiKey[] {
  const seen = new Set<string>()
  const keys: ProviderApiKey[] = []
  const storedKeys = Array.isArray(provider.apiKeys) ? provider.apiKeys : []
  for (const [index, key] of storedKeys.entries()) {
    if (!hasProviderKeyRecord(key)) continue
    if (!key.encryptedToken && key.sessionOnly !== true) continue
    const id = typeof key.id === 'string' && key.id.trim() ? key.id : randomUUID()
    if (seen.has(id)) continue
    seen.add(id)
    keys.push({
      id,
      label: cleanKeyLabel(key.label, `Key ${index + 1}`),
      encryptedToken: key.encryptedToken,
      sessionOnly: key.sessionOnly === true,
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

function credentialFor(providerId: string, key: ProviderApiKey) {
  return credentialBroker.resolve(
    { providerId, keyId: key.id },
    { encryptedToken: key.encryptedToken, sessionOnly: key.sessionOnly }
  )
}

function keyIsAvailable(providerId: string, key: ProviderApiKey): boolean {
  return credentialFor(providerId, key).available
}

function activeProviderKey(provider: Provider, keys = normalizedProviderKeys(provider)): ProviderApiKey | undefined {
  const activeId = provider.activeKeyId?.trim()
  const enabledKeys = keys.filter((key) => !key.disabled && keyIsAvailable(provider.id, key))
  return enabledKeys.find((key) => key.id === activeId) ?? enabledKeys[0]
}

function activeKeyIdFor(provider: Provider, keys: ProviderApiKey[], requestedId?: string): string | undefined {
  const activeId = requestedId?.trim() || provider.activeKeyId?.trim()
  const enabledKeys = keys.filter((key) => !key.disabled && keyIsAvailable(provider.id, key))
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

function appendNewKeys(
  providerId: string,
  keys: ProviderApiKey[],
  additions: ProviderApiKeyInput[] | undefined
): ProviderApiKey[] {
  if (!additions || additions.length === 0) return keys
  const next = [...keys]
  for (const input of additions) {
    const key = createApiKey(providerId, input, `Key ${next.length + 1}`)
    if (key) next.push(key)
  }
  return next
}

function withPrimaryToken(keys: ProviderApiKey[], provider: Provider, patch: Partial<ProviderInput>): ProviderApiKey[] {
  const tokenWasProvided = patch.token !== undefined
  const configuredActive = keys.find((key) => key.id === provider.activeKeyId && !key.disabled)
    ?? keys.find((key) => !key.disabled)
  if (tokenWasProvided) {
    const token = patch.token?.trim() ?? ''
    if (!token) {
      for (const key of keys) credentialBroker.forget({ providerId: provider.id, keyId: key.id })
      return []
    }
    const id = configuredActive?.id ?? randomUUID()
    const credential = credentialBroker.store({ providerId: provider.id, keyId: id }, token)
    const nextKey: ProviderApiKey = {
      id,
      label: cleanKeyLabel(patch.tokenLabel ?? configuredActive?.label, LEGACY_KEY_LABEL),
      encryptedToken: credential.encryptedToken,
      sessionOnly: credential.sessionOnly,
      createdAt: configuredActive?.createdAt ?? Date.now(),
      disabled: false
    }
    if (configuredActive) return keys.map((key) => key.id === configuredActive.id ? nextKey : key)
    return [nextKey, ...keys]
  }
  if (patch.tokenLabel !== undefined && configuredActive) {
    return keys.map((key) =>
      key.id === configuredActive.id ? { ...key, label: cleanKeyLabel(patch.tokenLabel, LEGACY_KEY_LABEL) } : key
    )
  }
  return keys
}

function providerKeyCount(provider: Provider): number {
  return normalizedProviderKeys(provider).filter((key) => !key.disabled && keyIsAvailable(provider.id, key)).length
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
  const credential = active ? credentialFor(provider.id, active) : null
  return {
    providerId: provider.id,
    keyId: active?.id,
    keyLabel: active?.label,
    token: credential?.token ?? ''
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
  const next = pickNextProviderKey(marked.filter((key) => keyIsAvailable(provider.id, key)), {
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
  persistBestEffort('保存 Provider 密钥轮换状态')
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
  const keys = normalizedProviderKeys(p)
  const active = activeProviderKey(p, keys)
  const apiKeys = keys.map((key) => {
    const credential = credentialFor(p.id, key)
    return {
      id: key.id,
      label: key.label,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt,
      lastFailureAt: key.lastFailureAt,
      lastFailureReason: key.lastFailureReason,
      disabled: key.disabled === true,
      active: active?.id === key.id,
      credentialStorage: providerCredentialStorage(credential.storage),
      available: credential.available
    }
  })
  const enabledKeyViews = apiKeys.filter((key) => !key.disabled)
  const keyCount = enabledKeyViews.filter((key) => key.available).length
  const credentialStorage = aggregateCredentialStorage(apiKeys.map((key) => key.credentialStorage))
  const customHeaders = inspectProviderCustomHeaders(p.customHeaders ?? '').safeValue.trim()
  return {
    id: p.id,
    name: p.name,
    baseUrl: inspectProviderBaseUrl(p.baseUrl).safeValue,
    models: p.models,
    engine: resolveProviderEngine(p),
    customHeaders: customHeaders || undefined,
    credentialHeaderNames: inspectCredentialHeaderNames(p.credentialHeaderNames).names,
    budgetUsd: normalizeBudget(p.budgetUsd),
    openaiProtocol: p.openaiProtocol,
    note: p.note,
    createdAt: p.createdAt,
    hasToken: keyCount > 0,
    keyCount,
    activeKeyId: active?.id,
    activeKeyLabel: active?.label,
    apiKeys,
    credentialStorage,
    credentialMigrationRequired: p.credentialMigrationRequired === true
  }
}

function providerCredentialStorage(storage: CredentialStorageState): ProviderView['credentialStorage'] {
  if (storage === 'missing') return 'none'
  return storage
}

function aggregateCredentialStorage(
  storages: Array<ProviderView['credentialStorage']>
): ProviderView['credentialStorage'] {
  const meaningful = [...new Set(storages.filter((storage) => storage !== 'none'))]
  if (meaningful.length === 0) return 'none'
  return meaningful.length === 1 ? meaningful[0] : 'mixed'
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
  persistBestEffort('保存 Provider 密钥运行状态')
}

function persistBestEffort(action: string): void {
  try {
    persist()
  } catch (err) {
    console.error(`[agent-desk] ${action}失败:`, err)
  }
}

export function listProviders(): ProviderView[] {
  return load().map(toView)
}

/** 主进程内部用:取完整 Provider(含加密 token) */
export function getProvider(id: string): Provider | undefined {
  return load().find((p) => p.id === id)
}

export function resolveProviderEngine(provider: Pick<Provider, 'engine' | 'name' | 'baseUrl' | 'models' | 'openaiProtocol'>): EngineKind {
  if (provider.engine === 'claude' || provider.engine === 'openai' || provider.engine === 'anthropic') {
    return provider.engine
  }
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
  const rawUrl = (baseUrl || '').trim().replace(/\/+$/, '')
  const inspected = inspectProviderBaseUrl(rawUrl)
  if (inspected.rejectedNames.length > 0) {
    throw new Error(`Base URL 不允许包含用户名、密码或非路由查询参数: ${inspected.rejectedNames.join(', ')}。凭据请使用 API 密钥字段。`)
  }
  const url = inspected.safeValue
  if (!url) return url
  // chat 协议走 OpenAI 引擎的 /v1/chat/completions,裸域名才是对的;
  // /anthropic 补全仅服务 Anthropic 协议引擎的 Messages 兼容路径。
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
  const providerId = randomUUID()
  assertProviderCredentialInput(input)
  const customHeaders = normalizedCustomHeaders(input.customHeaders)
  const credentialHeaderNames = normalizedCredentialHeaderNames(input.credentialHeaderNames)
  const baseUrl = normalizeBaseUrl(input.baseUrl, input.engine ?? 'openai', input.openaiProtocol)
  const list = load()
  const credentialSnapshot = credentialBroker.snapshotProvider(providerId)
  try {
    const primary = typeof input.token === 'string' && input.token.trim()
      ? createApiKey(providerId, { label: input.tokenLabel, token: input.token }, LEGACY_KEY_LABEL)
      : null
    const apiKeys = appendNewKeys(providerId, primary ? [primary] : [], input.additionalTokens)
    const activeKeyId = apiKeys.find((key) => !key.disabled && keyIsAvailable(providerId, key))?.id
    const activeKey = apiKeys.find((key) => key.id === activeKeyId)
    const provider: Provider = {
      id: providerId,
      name: input.name,
      baseUrl,
      encryptedToken: activeKey?.encryptedToken ?? '',
      apiKeys,
      activeKeyId,
      models: input.models,
      engine: input.engine ?? 'openai',
      customHeaders,
      credentialHeaderNames,
      budgetUsd: normalizeBudget(input.budgetUsd),
      openaiProtocol: input.openaiProtocol,
      note: input.note,
      createdAt: Date.now()
    }
    const view = toView(provider)
    cache = [...list, provider]
    persist()
    return view
  } catch (err) {
    cache = list
    credentialBroker.restoreProvider(providerId, credentialSnapshot)
    throw err
  }
}

export function updateProvider(id: string, patch: Partial<ProviderInput>): ProviderView {
  const list = load()
  const idx = list.findIndex((p) => p.id === id)
  if (idx === -1) throw new Error('Provider 不存在')
  assertProviderCredentialInput(patch)
  const prev = list[idx]
  const fields = resolveProviderPatchFields(prev, patch, {
    normalizedCustomHeaders,
    normalizedCredentialHeaderNames,
    normalizeBaseUrl,
    resolveProviderEngine
  })
  const credentialSnapshot = credentialBroker.snapshotProvider(id)
  try {
    let apiKeys = normalizedProviderKeys(prev)
    apiKeys = withPrimaryToken(apiKeys, prev, patch)
    apiKeys = applyKeyUpdates(apiKeys, patch.keyUpdates)
    apiKeys = removeProviderKeys(id, apiKeys, patch.removeKeyIds, (providerId, keyId) => {
      credentialBroker.forget({ providerId, keyId })
    })
    apiKeys = appendNewKeys(id, apiKeys, patch.additionalTokens)
    const activeKeyId = activeKeyIdFor(prev, apiKeys, patch.activeKeyId)
    const next = mergeProviderPatch(prev, patch, fields, apiKeys, activeKeyId, {
      normalizeBudget,
      resolveProviderEngine
    })
    const view = toView(next)
    cache = [...list.slice(0, idx), next, ...list.slice(idx + 1)]
    persist()
    return view
  } catch (err) {
    cache = list
    credentialBroker.restoreProvider(id, credentialSnapshot)
    throw err
  }
}

function normalizeBudget(value: unknown): number {
  if (value === undefined || value === null) return 0
  const budget = Number(value)
  return Number.isFinite(budget) && budget > 0 ? budget : 0
}

export function deleteProvider(id: string): void {
  const list = load()
  cache = list.filter((p) => p.id !== id)
  try {
    persist()
  } catch (err) {
    cache = list
    throw err
  }
  credentialBroker.forgetProvider(id)
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
  const requestedProviderId = opts.providerId?.trim()
  const provider = requestedProviderId ? getProvider(requestedProviderId) : undefined
  const bound = bindProviderModelDiscoveryInput(opts, provider)
  const credentialProvider = bound.usesStoredCredential ? provider : undefined
  return discoverProviderModels(bound.input, () => resolveModelDiscoveryCredentials(bound.input, credentialProvider), {
    success: (providerId, latencyMs) => recordSuccess(providerId, latencyMs),
    failure: (providerId, message) => recordFailure(providerId, message)
  })
}

function resolveModelDiscoveryCredentials(opts: ProviderModelFetchInput, provider: Provider | undefined) {
  let token = opts.token?.trim() || ''
  if (!token && provider) token = decryptProviderToken(provider)
  const credentialHeaderNames = normalizedCredentialHeaderNames(
    opts.credentialHeaderNames ?? provider?.credentialHeaderNames
  )
  const inspectedCustomHeaders = inspectProviderCustomHeaders(
    opts.customHeaders ?? provider?.customHeaders ?? ''
  )
  const customHeaders = parseProviderHeaderLines(inspectedCustomHeaders.safeValue)
  return {
    token,
    customHeaderRejections: inspectedCustomHeaders.rejectedNames,
    headers: {
      ...customHeaders,
      ...providerCredentialHeaders({ credentialHeaderNames }, token)
    }
  }
}
