import type { Provider, ProviderModelFetchInput } from '../../shared/types'
import { inspectProviderBaseUrl, inspectProviderCustomHeaders } from '../providerCredentialBroker'

export interface BoundProviderModelDiscoveryInput {
  input: ProviderModelFetchInput
  usesStoredCredential: boolean
}

export function bindProviderModelDiscoveryInput(
  input: ProviderModelFetchInput,
  provider: Provider | undefined
): BoundProviderModelDiscoveryInput {
  const explicitToken = input.token?.trim()
  if (explicitToken) {
    return {
      input: { ...input, token: explicitToken },
      usesStoredCredential: false
    }
  }

  const providerId = input.providerId?.trim()
  if (!providerId) return { input: { ...input, providerId: undefined }, usesStoredCredential: false }
  if (!provider || provider.id !== providerId) throw bindingError()

  assertSavedProviderBinding(input, provider)
  return {
    input: {
      baseUrl: provider.baseUrl,
      providerId: provider.id,
      customHeaders: provider.customHeaders,
      credentialHeaderNames: provider.credentialHeaderNames,
      openaiProtocol: provider.openaiProtocol
    },
    usesStoredCredential: true
  }
}

function assertSavedProviderBinding(input: ProviderModelFetchInput, provider: Provider): void {
  const requestedBaseUrl = canonicalBaseUrl(input.baseUrl)
  const savedBaseUrl = canonicalBaseUrl(provider.baseUrl)
  if (requestedBaseUrl === null || savedBaseUrl === null || requestedBaseUrl !== savedBaseUrl) {
    throw bindingError()
  }
  if (
    input.customHeaders !== undefined
    && !sameCustomHeaders(input.customHeaders, provider.customHeaders)
  ) {
    throw bindingError()
  }
  if (
    input.credentialHeaderNames !== undefined
    && canonicalCredentialHeaderNames(input.credentialHeaderNames)
      !== canonicalCredentialHeaderNames(provider.credentialHeaderNames)
  ) {
    throw bindingError()
  }
  if (
    input.openaiProtocol !== undefined
    && canonicalProtocol(input.openaiProtocol) !== canonicalProtocol(provider.openaiProtocol)
  ) {
    throw bindingError()
  }
}

function canonicalBaseUrl(value: string): string | null {
  const inspected = inspectProviderBaseUrl(value ?? '')
  if (inspected.rejectedNames.length > 0) return null
  return inspected.safeValue.trim().replace(/\/+$/, '')
}

function sameCustomHeaders(requested: string, saved: string | undefined): boolean {
  const requestedInspection = inspectProviderCustomHeaders(requested)
  const savedInspection = inspectProviderCustomHeaders(saved ?? '')
  return requestedInspection.rejectedNames.length === 0
    && savedInspection.rejectedNames.length === 0
    && requestedInspection.safeValue.trim() === savedInspection.safeValue.trim()
}

function canonicalCredentialHeaderNames(value: string[] | undefined): string {
  return [...new Set((value ?? []).map((name) => name.trim().toLowerCase()).filter(Boolean))]
    .sort()
    .join('\n')
}

function canonicalProtocol(value: ProviderModelFetchInput['openaiProtocol']): 'chat' | 'responses' {
  return value === 'chat' ? 'chat' : 'responses'
}

function bindingError(): Error {
  return new Error('已保存 Provider 的模型探测必须使用其已保存的网络目标和鉴权配置')
}
