import type { Provider } from '../../shared/types'
import {
  getProvider,
  issueProviderCredentialLease,
  selectProviderCredential,
  type ProviderCredentialLeaseSelection
} from '../providers'
import { inspectProviderBaseUrl, inspectProviderCustomHeaders } from '../providerCredentialBroker'
import type { ProviderCredentialLeaseScope } from '../providerCredentialBroker'
import { configureProviderReliabilityPolicy } from '../providerHealth'
import type { AnthropicMessagesTarget } from './anthropicMessagesTarget'
import { appendProviderRequestQuery } from './providerRequestOverrides'
import { providerRequestTimeouts } from './providerRequestTimeout'
import { resolveProviderRuntimeTarget } from './providerRuntimeTarget'

const DEFAULT_GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

interface Dependencies {
  getProvider(id: string): Provider | undefined
  selectProviderCredential(provider: Provider | undefined): ProviderCredentialLeaseSelection
  issueProviderCredentialLease(
    provider: Provider,
    scope: ProviderCredentialLeaseScope,
    expectedKeyId?: string
  ): ProviderCredentialLeaseSelection
}

const DEFAULT_DEPENDENCIES: Dependencies = {
  getProvider,
  selectProviderCredential,
  issueProviderCredentialLease: (provider, scope, expectedKeyId) =>
    issueProviderCredentialLease(provider, scope, {}, expectedKeyId)
}

export function resolveGoogleGenAiTarget(
  input: { providerId: string; model?: string },
  dependencies: Dependencies = DEFAULT_DEPENDENCIES
): AnthropicMessagesTarget {
  const providerId = input.providerId.trim()
  if (!providerId) throw new Error('Google Generative Language requires an explicit Provider')
  const provider = dependencies.getProvider(providerId)
  if (!provider || provider.id !== providerId) throw new Error(`Provider not found: ${providerId}`)
  if (provider.engine !== 'gemini') throw new Error(`Provider ${providerId} is not a Gemini Provider`)
  configureProviderReliabilityPolicy(provider)
  const selection = dependencies.selectProviderCredential(provider)
  if (selection.authMode !== 'none' && !selection.available) {
    throw new Error(`${provider.name} has no available API key`)
  }
  const runtimeTarget = resolveProviderRuntimeTarget(provider, { appId: 'gemini', model: input.model })
  const baseUrl = safeBaseUrl(runtimeTarget.baseUrl || provider.baseUrl)
  const model = runtimeTarget.model.replace(/^models\//, '')
  if (!model) throw new Error(`Provider ${provider.id} has no Gemini model`)
  const credentialProvider = provider.credentialHeaderNames?.length
    ? provider : { ...provider, credentialHeaderNames: ['x-goog-api-key'] }
  const endpoint = appendProviderRequestQuery(
    googleGenerativeLanguageEndpoint(baseUrl, model, 'streamGenerateContent'),
    baseUrl,
    { alt: 'sse', ...(provider.advancedConfig?.request?.query ?? {}) }
  )
  return {
    providerId: provider.id,
    providerName: provider.name,
    baseUrl,
    endpoint,
    model,
    headers: {
      accept: 'text/event-stream',
      'content-type': 'application/json',
      ...savedHeaders(provider.customHeaders),
      ...(provider.advancedConfig?.request?.headers ?? {})
    },
    timeouts: providerRequestTimeouts(provider),
    credentialProvider,
    issueCredentialLease: (scope) =>
      dependencies.issueProviderCredentialLease(provider, scope, selection.keyId),
    keyId: selection.keyId,
    keyLabel: selection.keyLabel
  }
}

function safeBaseUrl(value: string): string {
  const inspected = inspectProviderBaseUrl(value.trim() || DEFAULT_GOOGLE_BASE_URL)
  if (!inspected.safeValue || inspected.rejectedNames.length > 0) {
    throw new Error('Google Generative Language network target is invalid')
  }
  return inspected.safeValue.replace(/\/+$/, '')
}

export function googleGenerativeLanguageEndpoint(
  baseUrl: string,
  model: string,
  method: 'generateContent' | 'streamGenerateContent'
): string {
  const url = new URL(baseUrl)
  let path = url.pathname.replace(/\/+$/, '')
  if (!/\/v1(?:beta)?$/i.test(path)) path = `${path}/v1beta`
  url.pathname = `${path}/models/${encodeURIComponent(model.replace(/^models\//, ''))}:${method}`
  return url.toString().replace(/\/$/, '')
}

function savedHeaders(raw: string | undefined): Record<string, string> {
  const inspected = inspectProviderCustomHeaders(raw ?? '')
  if (inspected.rejectedNames.length > 0) throw new Error('Saved Google Provider headers are unsafe')
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
