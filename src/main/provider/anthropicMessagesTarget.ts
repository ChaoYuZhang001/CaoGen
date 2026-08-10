import type { Provider } from '../../shared/types'
import {
  getProvider,
  issueProviderCredentialLease,
  selectProviderCredential,
  type ProviderCredentialLeaseSelection
} from '../providers'
import {
  inspectProviderBaseUrl,
  inspectProviderCustomHeaders
} from '../providerCredentialBroker'
import type { ProviderCredentialLeaseScope } from '../providerCredentialBroker'
import { appendProviderRequestQuery } from './providerRequestOverrides'
import { resolveProviderRuntimeTarget } from './providerRuntimeTarget'
import { configureProviderReliabilityPolicy } from '../providerHealth'
import { providerRequestTimeouts, type ProviderRequestTimeouts } from './providerRequestTimeout'

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01'

export interface AnthropicMessagesTarget {
  providerId: string
  providerName: string
  baseUrl: string
  endpoint: string
  model: string
  headers: Record<string, string>
  timeouts?: ProviderRequestTimeouts
  credentialProvider: Pick<
    Provider,
    'authMode' | 'baseUrl' | 'credentialMigrationRequired' | 'customHeaders' | 'credentialHeaderNames' | 'advancedConfig'
  >
  issueCredentialLease(scope: ProviderCredentialLeaseScope): ProviderCredentialLeaseSelection
  keyId?: string
  keyLabel?: string
}

export interface AnthropicMessagesTargetDependencies {
  getProvider(id: string): Provider | undefined
  selectProviderCredential(provider: Provider | undefined): ProviderCredentialLeaseSelection
  issueProviderCredentialLease(
    provider: Provider,
    scope: ProviderCredentialLeaseScope,
    expectedKeyId?: string
  ): ProviderCredentialLeaseSelection
}

const DEFAULT_DEPENDENCIES: AnthropicMessagesTargetDependencies = {
  getProvider,
  selectProviderCredential,
  issueProviderCredentialLease: (provider, scope, expectedKeyId) =>
    issueProviderCredentialLease(provider, scope, {}, expectedKeyId)
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
  if (provider) configureProviderReliabilityPolicy(provider)
  if (!provider || provider.id !== providerId) throw new Error(`Provider 不存在:${providerId}`)

  const selection = dependencies.selectProviderCredential(provider)
  if (selection.authMode !== 'none' && !selection.available) {
    throw new Error(`${provider.name} 缺少可用 API Key`)
  }

  const runtimeTarget = resolveProviderRuntimeTarget(provider, { appId: 'anthropic', model: input.model })
  const baseUrl = savedBaseUrl(provider, runtimeTarget.baseUrl)
  const model = runtimeTarget.model
  if (!model) throw new Error(`Provider ${provider.id} has no Anthropic model`)
  const customHeaders = parseSavedHeaders(provider.customHeaders)
  const credentialProvider = provider.credentialHeaderNames?.length
    ? provider
    : { ...provider, credentialHeaderNames: ['x-api-key'] }
  const headers = {
    accept: 'text/event-stream',
    'content-type': 'application/json',
    'anthropic-version': customHeaders['anthropic-version'] || DEFAULT_ANTHROPIC_VERSION,
    ...customHeaders,
    ...(provider.advancedConfig?.request?.headers ?? {})
  }
  const endpoint = appendProviderRequestQuery(
    messagesEndpoint(baseUrl),
    baseUrl,
    provider.advancedConfig?.request?.query
  )

  return {
    providerId: provider.id,
    providerName: provider.name,
    baseUrl,
    endpoint,
    model,
    headers,
    timeouts: providerRequestTimeouts(provider),
    credentialProvider,
    issueCredentialLease: (scope) =>
      dependencies.issueProviderCredentialLease(provider, scope, selection.keyId),
    keyId: selection.keyId,
    keyLabel: selection.keyLabel
  }
}

function savedBaseUrl(provider: Provider, resolvedBaseUrl: string): string {
  const raw = resolvedBaseUrl.trim() || DEFAULT_ANTHROPIC_BASE_URL
  const inspected = inspectProviderBaseUrl(raw)
  if (!inspected.safeValue || inspected.rejectedNames.length > 0) {
    throw new Error(`Provider ${provider.id} 的 Anthropic 网络目标无效`)
  }
  return inspected.safeValue.replace(/\/+$/, '')
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
