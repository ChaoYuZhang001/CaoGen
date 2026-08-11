import type { OutboundContextManifest, RoutingExpertPolicy } from '../../shared/types'
import { getProvider, listProviders, providerIsReady } from '../providers'
import { providerAllowedByRoutingExpertPolicy } from '../model/routing-expert-policy'
import { providerAllowedByOutboundContext } from '../project-workspace/outbound-context-policy'
import { resolveOpenAIProtocol, resolveProviderRuntimeTarget } from './providerRuntimeTarget'
import { pickFailoverTarget, pickProviderModelFailoverTarget, type FailureClass } from '../scheduler'
import type { OpenAIProtocol } from '../../shared/types'
import { synchronizeProviderReliabilityPolicies } from '../providerHealth'

export interface OpenAiProviderModelRecoveryPlan {
  providerId: string
  providerName: string
  fromModel: string
  toModel: string
  routeReason: string
}

export interface OpenAiProviderFailoverPlan {
  providerId: string
  name: string
  model?: string
  fromName: string
  routeReason: string
}

export interface OpenAiProtocolRecoveryPlan {
  providerId: string
  providerName: string
  model: string
  fromProtocol: 'responses'
  toProtocol: 'chat'
  routeReason: string
}

export class OpenAiRecoveryState {
  readonly providers: Set<string>
  readonly keys = new Set<string>()
  private readonly modelsByProvider = new Map<string, Set<string>>()
  private attempts = 0

  constructor(activeProviderId?: string) {
    this.providers = new Set(activeProviderId ? [activeProviderId] : [])
  }

  models(providerId: string): Set<string> {
    let models = this.modelsByProvider.get(providerId)
    if (!models) {
      models = new Set()
      this.modelsByProvider.set(providerId, models)
    }
    return models
  }

  canRecover(providerId: string | undefined, globalEnabled: boolean): boolean {
    const reliability = providerId ? getProvider(providerId)?.advancedConfig?.reliability : undefined
    return this.isEnabled(providerId, globalEnabled)
      && (reliability?.maxRetries === undefined || this.attempts < reliability.maxRetries)
  }

  isEnabled(providerId: string | undefined, globalEnabled: boolean): boolean {
    return providerId
      ? getProvider(providerId)?.advancedConfig?.reliability?.failoverEnabled ?? globalEnabled
      : globalEnabled
  }

  recordRecovery(): void {
    this.attempts += 1
  }
}

export async function firstSuccessfulRecovery(
  ...recoveries: Array<() => Promise<boolean>>
): Promise<boolean> {
  for (const recover of recoveries) if (await recover()) return true
  return false
}

export function planOpenAiProviderModelRecovery(input: {
  providerId: string
  fromModel: string
  fallbackModel?: string
  failure: FailureClass
  exclude: ReadonlySet<string>
  outboundContext?: OutboundContextManifest
  routingExpertPolicy?: RoutingExpertPolicy
}): OpenAiProviderModelRecoveryPlan | null {
  const provider = getProvider(input.providerId)
  const providerView = listProviders().find((candidate) => candidate.id === input.providerId)
  if (!provider || providerView?.engine !== 'openai' || !providerIsReady(provider)) return null
  if (input.routingExpertPolicy && !providerAllowedByRoutingExpertPolicy(providerView, input.routingExpertPolicy)) return null
  const models = [...new Set(provider.models.map((model) =>
    resolveProviderRuntimeTarget(provider, { appId: 'openai', model }).model
  ))].filter((model) => providerAllowedByOutboundContext(input.outboundContext, providerView, model))
  const target = pickProviderModelFailoverTarget({
    providerId: input.providerId,
    models,
    desiredModel: input.fromModel,
    exclude: input.exclude,
    fallbackModel: input.fallbackModel,
    failure: input.failure
  })
  if (!target) return null
  return {
    providerId: input.providerId,
    providerName: providerView.name,
    fromModel: input.fromModel,
    toModel: target.model,
    routeReason: [input.failure.label, target.preference].filter(Boolean).join(' / ')
  }
}

export function planOpenAiProviderFailover(input: {
  currentProviderId: string
  currentModel: string
  fallbackProviderId?: string
  fallbackModel?: string
  failure: FailureClass
  currentProtocol: OpenAIProtocol
  exclude: Set<string>
  outboundContext?: OutboundContextManifest
  routingExpertPolicy?: RoutingExpertPolicy
}): OpenAiProviderFailoverPlan | null {
  if (!input.failure.switchable) return null
  const providers = listProviders()
  synchronizeProviderReliabilityPolicies(providers)
  const candidates = providers
    .filter((provider) => provider.engine === 'openai' && provider.baseUrl.trim() && providerIsReady(provider))
    .filter((provider) => !input.routingExpertPolicy || providerAllowedByRoutingExpertPolicy(provider, input.routingExpertPolicy))
    .map((provider) => {
      const sourceModels = provider.models.length > 0 ? provider.models : [input.currentModel]
      const models = [...new Set(sourceModels.flatMap((model) => {
        try {
          const target = resolveProviderRuntimeTarget(provider, { appId: 'openai', model })
          if (resolveOpenAIProtocol(target) !== input.currentProtocol) return []
          if (!providerAllowedByOutboundContext(input.outboundContext, provider, target.model)) return []
          return target.model ? [target.model] : []
        } catch {
          return []
        }
      }))]
      return { id: provider.id, name: provider.name, models }
    })
    .filter((provider) => provider.models.length > 0)
  const target = pickFailoverTarget({
    candidates,
    exclude: input.exclude,
    desiredModel: input.currentModel,
    fallbackProviderId: input.fallbackProviderId,
    fallbackModel: input.fallbackModel
  })
  if (!target) return null
  return {
    ...target,
    fromName: providers.find((provider) => provider.id === input.currentProviderId)?.name ??
      input.currentProviderId ?? 'Current Provider',
    routeReason: [input.failure.label, target.preference].filter(Boolean).join(' / ')
  }
}

export function planOpenAiProtocolRecovery(input: {
  providerId: string
  model: string
  currentProtocol: OpenAIProtocol
  failure: FailureClass
}): OpenAiProtocolRecoveryPlan | null {
  if (input.currentProtocol !== 'responses' || input.failure.kind !== 'protocol_unavailable') return null
  const provider = getProvider(input.providerId)
  const providerView = listProviders().find((candidate) => candidate.id === input.providerId)
  if (!provider || providerView?.engine !== 'openai' || !providerIsReady(provider)) return null
  const target = resolveProviderRuntimeTarget(provider, { appId: 'openai', model: input.model })
  if (resolveOpenAIProtocol(target) !== 'responses') return null
  return {
    providerId: input.providerId,
    providerName: providerView.name,
    model: target.model || input.model,
    fromProtocol: 'responses',
    toProtocol: 'chat',
    routeReason: `${input.failure.label} / Responses → Chat Completions`
  }
}
