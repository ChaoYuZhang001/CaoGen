import type { Provider } from '../../shared/types'
import {
  getProvider,
  resolveProviderToken,
  type ProviderTokenSelection
} from '../providers'
import {
  inspectProviderBaseUrl,
  inspectProviderCustomHeaders
} from '../providerCredentialBroker'
import { mergeProviderCredentialHeaders } from '../providerRuntimeAuth'

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01'

export interface AnthropicMessagesTarget {
  providerId: string
  providerName: string
  baseUrl: string
  endpoint: string
  model: string
  headers: Record<string, string>
  token: string
  keyId?: string
  keyLabel?: string
}

export interface AnthropicMessagesTargetDependencies {
  getProvider(id: string): Provider | undefined
  resolveProviderToken(provider: Provider | undefined): ProviderTokenSelection
}

const DEFAULT_DEPENDENCIES: AnthropicMessagesTargetDependencies = {
  getProvider,
  resolveProviderToken
}

/**
 * Bind a native Messages request to the saved Provider record. Callers supply only
 * Provider/model identity; network target, headers, and credentials always come
 * from the main-process Provider store and Credential Broker.
 */
export function resolveAnthropicMessagesTarget(
  input: { providerId: string; model?: string },
  dependencies: AnthropicMessagesTargetDependencies = DEFAULT_DEPENDENCIES
): AnthropicMessagesTarget {
  const providerId = input.providerId.trim()
  if (!providerId) throw new Error('Anthropic Messages requires an explicit Provider')
  const provider = dependencies.getProvider(providerId)
  if (!provider || provider.id !== providerId) throw new Error(`Provider 不存在:${providerId}`)

  const selection = dependencies.resolveProviderToken(provider)
  if (!selection.token) throw new Error(`${provider.name} 缺少可用 API Key`)

  const baseUrl = savedBaseUrl(provider)
  const model = selectedModel(input.model, provider)
  const customHeaders = parseSavedHeaders(provider.customHeaders)
  const credentialProvider = provider.credentialHeaderNames?.length
    ? provider
    : { ...provider, credentialHeaderNames: ['x-api-key'] }
  const headers = mergeProviderCredentialHeaders(credentialProvider, selection.token, {
    accept: 'text/event-stream',
    'content-type': 'application/json',
    'anthropic-version': customHeaders['anthropic-version'] || DEFAULT_ANTHROPIC_VERSION,
    ...customHeaders
  })

  return {
    providerId: provider.id,
    providerName: provider.name,
    baseUrl,
    endpoint: messagesEndpoint(baseUrl),
    model,
    headers,
    token: selection.token,
    keyId: selection.keyId,
    keyLabel: selection.keyLabel
  }
}

function savedBaseUrl(provider: Provider): string {
  const raw = provider.baseUrl.trim() || DEFAULT_ANTHROPIC_BASE_URL
  const inspected = inspectProviderBaseUrl(raw)
  if (!inspected.safeValue || inspected.rejectedNames.length > 0) {
    throw new Error(`Provider ${provider.id} 的 Anthropic 网络目标无效`)
  }
  return inspected.safeValue.replace(/\/+$/, '')
}

function selectedModel(requested: string | undefined, provider: Provider): string {
  const explicit = requested?.trim()
  const model = explicit && explicit !== 'auto' ? explicit : provider.models.find((item) => item.trim())?.trim()
  if (!model) throw new Error(`Provider ${provider.id} 未配置 Anthropic 模型`)
  return model
}

function parseSavedHeaders(raw: string | undefined): Record<string, string> {
  const inspected = inspectProviderCustomHeaders(raw ?? '')
  if (inspected.rejectedNames.length > 0) {
    throw new Error('Provider 保存的自定义请求头未通过安全检查')
  }
  const headers: Record<string, string> = {}
  for (const line of inspected.safeValue.split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const name = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    if (name && value) headers[name] = value
  }
  return headers
}

function messagesEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl)
  const path = url.pathname.replace(/\/+$/, '')
  if (/\/v1\/messages$/i.test(path)) {
    url.pathname = path
  } else if (/\/v1$/i.test(path)) {
    url.pathname = `${path}/messages`
  } else {
    url.pathname = `${path}/v1/messages`.replace(/^\/\//, '/')
  }
  return url.toString().replace(/\/$/, '')
}
