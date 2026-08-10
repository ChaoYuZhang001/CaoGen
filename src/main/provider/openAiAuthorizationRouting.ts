import type { OpenAIProtocol, Provider } from '../../shared/types'
import { providerAuthMode, selectProviderCredential } from '../providers'
import { configureProviderReliabilityPolicy } from '../providerHealth'
import { parseProviderHeaders } from './openai-provider-utils'
import { resolveProviderRuntimeTarget } from './providerRuntimeTarget'
import {
  providerAuthorizationAccountKeyId,
  resolveProviderAuthorizationAccountSelection
} from './providerAuthorizationAccountService'

export interface OpenAiAuthorizationRoute {
  available: boolean
  keyId?: string
  keyLabel?: string
  authorizationAccountId?: string
  authorizationAccountExplicit?: boolean
  authorizationRouteReason?: string
}

export interface OpenAIAuthConfig {
  baseUrl: string
  authMode: 'api-key' | 'none'
  headers: Record<string, string>
  providerId: string
  available: boolean
  provider?: Provider
  environmentCredential: boolean
  keyId?: string
  keyLabel?: string
  authorizationAccountId?: string
  authorizationAccountExplicit?: boolean
  authorizationRouteReason?: string
}

export function resolveOpenAiAuthConfig(input: {
  provider?: Provider
  providerId?: string
  model: string
  protocol: OpenAIProtocol
}): OpenAIAuthConfig {
  if (input.provider) configureProviderReliabilityPolicy(input.provider)
  const runtimeTarget = input.provider
    ? resolveProviderRuntimeTarget(input.provider, { appId: 'openai', model: input.model })
    : undefined
  let baseUrl = (runtimeTarget?.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '')
  if (input.protocol === 'chat') baseUrl = baseUrl.replace(/\/anthropic$/, '')
  const providerId = input.provider?.id || input.providerId || 'openai'
  const selection = input.provider
    ? selectProviderCredential(input.provider)
    : {
        providerId,
        keyId: 'environment:OPENAI_API_KEY',
        authMode: 'api-key' as const,
        available: Boolean(process.env.OPENAI_API_KEY)
      }
  const authorizationRoute = resolveOpenAiAuthorizationRoute(input.provider, runtimeTarget?.accountId)
  return {
    baseUrl,
    authMode: providerAuthMode(input.provider),
    headers: parseProviderHeaders(input.provider?.customHeaders),
    providerId,
    available: authorizationRoute?.available ?? selection.available,
    provider: input.provider ? { ...input.provider, baseUrl } : undefined,
    environmentCredential: !input.provider,
    keyId: authorizationRoute ? authorizationRoute.keyId : selection.keyId,
    keyLabel: authorizationRoute ? authorizationRoute.keyLabel : selection.keyLabel,
    ...authorizationRoute
  }
}

export function resolveOpenAiAuthorizationRoute(
  provider: Provider | undefined,
  explicitAccountId?: string
): OpenAiAuthorizationRoute | undefined {
  if (!provider?.authorization?.provider || provider.authorization.status !== 'authorized') return undefined
  const decision = resolveProviderAuthorizationAccountSelection(provider, explicitAccountId)
  const account = decision.account
  return {
    available: Boolean(account),
    keyId: account ? providerAuthorizationAccountKeyId(provider, account.id) : undefined,
    keyLabel: account ? `OAuth - ${account.label}` : undefined,
    authorizationAccountId: account?.id,
    authorizationAccountExplicit: Boolean(explicitAccountId),
    authorizationRouteReason: decision.reason
  }
}
