import type { Provider } from '../../shared/types'
import type {
  ProviderBalanceCapabilityView,
  ProviderBalanceItemView,
  ProviderBalanceQueryConfig,
  ProviderBalanceResponseConfig,
  ProviderBalanceSource,
  ProviderBalanceView
} from '../../shared/provider-balance-types'
import {
  getProvider,
  issueProviderCredentialLease
} from '../providers'
import { fetchWithProviderCredentialLease } from '../providerRuntimeAuth'
import { ensureProviderAuthorizationFresh } from './providerAuthorizationService'
import { recordProviderCredentialBalance } from './providerCredentialMetrics'

const MAX_RESPONSE_BYTES = 512 * 1024
const REQUEST_TIMEOUT_MS = 15_000

interface ResolvedBalanceQuery {
  config: ProviderBalanceQueryConfig
  source: ProviderBalanceSource
  label: string
}

interface BuiltinBalanceAdapter {
  hosts: readonly string[]
  label: string
  config: ProviderBalanceQueryConfig
}

const BUILTIN_ADAPTERS: readonly BuiltinBalanceAdapter[] = [
  {
    hosts: ['api.deepseek.com'],
    label: 'DeepSeek balance',
    config: {
      path: '/user/balance',
      response: { itemsPath: '/balance_infos', labelPath: '/currency', unitPath: '/currency', remainingPath: '/total_balance' }
    }
  },
  {
    hosts: ['api.stepfun.ai', 'api.stepfun.com'],
    label: 'StepFun balance',
    config: {
      path: '/v1/accounts',
      response: { label: 'StepFun', unit: 'CNY', remainingPath: '/balance' }
    }
  },
  {
    hosts: ['api.siliconflow.cn'],
    label: 'SiliconFlow balance',
    config: {
      path: '/v1/user/info',
      response: { label: 'SiliconFlow', unit: 'CNY', remainingPath: '/data/totalBalance' }
    }
  },
  {
    hosts: ['api.siliconflow.com'],
    label: 'SiliconFlow (EN) balance',
    config: {
      path: '/v1/user/info',
      response: { label: 'SiliconFlow (EN)', unit: 'USD', remainingPath: '/data/totalBalance' }
    }
  },
  {
    hosts: ['openrouter.ai'],
    label: 'OpenRouter credits',
    config: {
      path: '/api/v1/credits',
      response: { label: 'OpenRouter', unit: 'USD', totalPath: '/data/total_credits', usedPath: '/data/total_usage' }
    }
  },
  {
    hosts: ['api.novita.ai'],
    label: 'Novita AI balance',
    config: {
      path: '/v3/user/balance',
      response: { label: 'Novita AI', unit: 'USD', remainingPath: '/availableBalance', scale: 0.0001 }
    }
  }
]

export function inspectProviderBalance(providerId: string): ProviderBalanceCapabilityView {
  const provider = requireProvider(providerId)
  const resolved = resolveBalanceQuery(provider)
  if (!resolved) return { providerId: provider.id, supported: false }
  return {
    providerId: provider.id,
    supported: true,
    source: resolved.source,
    label: resolved.label,
    credentialMode: resolved.config.credentialMode ?? 'provider',
    ...(resolved.config.keyLabel ? { keyLabel: resolved.config.keyLabel } : {})
  }
}

export async function queryProviderBalance(
  providerId: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now()
): Promise<ProviderBalanceView> {
  let provider = requireProvider(providerId)
  if (provider.authorization?.provider && provider.authorization.status === 'authorized') {
    await ensureProviderAuthorizationFresh(providerId, fetchImpl, now).catch(() => undefined)
    provider = requireProvider(providerId)
  }
  const resolved = resolveBalanceQuery(provider)
  if (!resolved) return unavailable(provider.id, now, undefined, 'unsupported_provider')

  let requestProvider: Provider = provider
  let lease
  let selectedKeyId: string | undefined
  const scope = {
    providerId: provider.id,
    projectId: 'system:provider-balance',
    sessionId: `provider-balance:${provider.id}`,
    operationId: `balance:${now}`
  }
  if ((resolved.config.credentialMode ?? 'provider') === 'provider' && provider.authMode !== 'none') {
    const keyId = resolveKeyId(provider, resolved.config.keyLabel)
    if (resolved.config.keyLabel && !keyId) return unavailable(provider.id, now, resolved.source, 'balance_key_not_found')
    const selection = issueProviderCredentialLease(provider, scope, {}, keyId)
    if (!selection.available || !selection.lease) return unavailable(provider.id, now, resolved.source, 'credential_unavailable')
    lease = selection.lease
    selectedKeyId = selection.keyId
  } else if ((resolved.config.credentialMode ?? 'provider') === 'none') {
    requestProvider = { ...provider, authMode: 'none' }
  }

  const url = buildProviderBalanceUrl(provider.baseUrl, resolved.config)
  if (!url) return unavailable(provider.id, now, resolved.source, 'balance_endpoint_untrusted')
  const headers = { ...(resolved.config.headers ?? {}) }
  if (resolved.config.body && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
    headers['content-type'] = 'application/json'
  }
  const init: RequestInit & { headers?: Record<string, string> } = {
    method: resolved.config.method ?? 'GET',
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(resolved.config.body ? { body: JSON.stringify(resolved.config.body) } : {})
  }
  try {
    const response = await fetchWithProviderCredentialLease({
      provider: requestProvider,
      lease,
      scope,
      url: url.toString(),
      init,
      fetch: fetchImpl
    })
    if (response.status === 401 || response.status === 403) return unavailable(provider.id, now, resolved.source, 'authorization_expired', 'expired')
    if (response.status >= 300 && response.status < 400) return unavailable(provider.id, now, resolved.source, 'redirect_blocked')
    if (!response.ok) return unavailable(provider.id, now, resolved.source, `http_${response.status}`)
    const length = finiteNumber(response.headers.get('content-length'))
    if (length !== undefined && length > MAX_RESPONSE_BYTES) return unavailable(provider.id, now, resolved.source, 'response_too_large')
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_RESPONSE_BYTES) return unavailable(provider.id, now, resolved.source, 'response_too_large')
    let root: unknown
    try {
      root = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      return unavailable(provider.id, now, resolved.source, 'invalid_json')
    }
    const items = extractProviderBalanceItems(root, resolved.config.response)
    if (!items || items.length === 0) return unavailable(provider.id, now, resolved.source, 'invalid_response')
    recordProviderCredentialBalance(provider.id, selectedKeyId, usdRemaining(items))
    return { providerId: provider.id, status: 'ready', source: resolved.source, queriedAt: now, items }
  } catch {
    return unavailable(provider.id, now, resolved.source, 'network_error')
  }
}

function usdRemaining(items: ProviderBalanceItemView[]): number | undefined {
  const values = items.flatMap((item) => {
    if (item.remaining === undefined) return []
    const unit = item.unit?.trim().toUpperCase()
    return !unit || unit === 'USD' || unit === 'USDT' ? [item.remaining] : []
  })
  return values.length > 0 ? roundNumber(values.reduce((sum, value) => sum + value, 0)) : undefined
}

function resolveBalanceQuery(provider: Provider): ResolvedBalanceQuery | undefined {
  if (provider.advancedConfig?.balanceQuery) {
    return { config: provider.advancedConfig.balanceQuery, source: 'custom', label: 'Custom balance query' }
  }
  let host: string
  try { host = new URL(provider.baseUrl).hostname.toLowerCase() } catch { return undefined }
  const adapter = BUILTIN_ADAPTERS.find((candidate) => candidate.hosts.includes(host))
  return adapter ? { config: adapter.config, source: 'builtin', label: adapter.label } : undefined
}

export function buildProviderBalanceUrl(baseUrl: string, config: ProviderBalanceQueryConfig): URL | undefined {
  try {
    const base = new URL(baseUrl)
    const target = new URL(config.path, base)
    if (target.origin !== base.origin || target.username || target.password || target.hash) return undefined
    for (const [key, value] of Object.entries(config.query ?? {})) target.searchParams.set(key, value)
    return target
  } catch {
    return undefined
  }
}

function resolveKeyId(provider: Provider, label: string | undefined): string | undefined {
  if (!label) return undefined
  const matches = (provider.apiKeys ?? []).filter((key) => !key.disabled && key.label === label)
  return matches.length === 1 ? matches[0].id : undefined
}

export function extractProviderBalanceItems(root: unknown, config: ProviderBalanceResponseConfig): ProviderBalanceItemView[] | null {
  const itemRoot = readPointer(root, config.itemsPath)
  if (itemRoot === undefined) return null
  const entries = Array.isArray(itemRoot) ? itemRoot.slice(0, 50) : [itemRoot]
  const items: ProviderBalanceItemView[] = []
  for (const entry of entries) {
    const remaining = scaledNumber(readPointer(entry, config.remainingPath), config.scale)
    const total = scaledNumber(readPointer(entry, config.totalPath), config.scale)
    const used = scaledNumber(readPointer(entry, config.usedPath), config.scale)
    const computedRemaining = remaining ?? (total !== undefined && used !== undefined ? total - used : undefined)
    if (computedRemaining === undefined && total === undefined && used === undefined) continue
    const labelValue = config.label ?? textValue(readPointer(entry, config.labelPath))
    const unitValue = config.unit ?? textValue(readPointer(entry, config.unitPath))
    const validValue = readPointer(entry, config.validPath)
    items.push({
      ...(labelValue ? { label: labelValue } : {}),
      ...(unitValue ? { unit: unitValue } : {}),
      ...(computedRemaining === undefined ? {} : { remaining: roundNumber(computedRemaining) }),
      ...(total === undefined ? {} : { total: roundNumber(total) }),
      ...(used === undefined ? {} : { used: roundNumber(used) }),
      ...(typeof validValue === 'boolean' ? { valid: validValue } : {})
    })
  }
  return items
}

function readPointer(root: unknown, pointer: string | undefined): unknown {
  if (!pointer) return root
  let current = root
  for (const rawSegment of pointer.slice(1).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) return undefined
      current = current[index]
    } else if (current && typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment]
    } else return undefined
  }
  return current
}

function scaledNumber(value: unknown, scale = 1): number | undefined {
  const number = finiteNumber(value)
  return number === undefined ? undefined : number * scale
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : undefined
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) ? number : undefined
}

function roundNumber(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function requireProvider(providerId: string): Provider {
  const provider = getProvider(providerId.trim())
  if (!provider) throw new Error('Provider was not found')
  return provider
}

function unavailable(
  providerId: string,
  queriedAt: number,
  source: ProviderBalanceSource | undefined,
  errorCode: string,
  status: ProviderBalanceView['status'] = 'unavailable'
): ProviderBalanceView {
  return { providerId, status, queriedAt, items: [], ...(source ? { source } : {}), errorCode }
}
