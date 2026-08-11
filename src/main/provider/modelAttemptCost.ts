import type { ModelAttemptUsage } from '../../shared/model-attempt-types'
import { getProvider } from '../providers'
import {
  builtinOpenAiPricingForModel,
  estimateProviderCostUsd,
  providerPricingForModel
} from './providerAdvancedConfig'

export interface ModelAttemptCostIdentity {
  providerId: string
  model: string
  protocol: string
}

export function canEstimateModelAttemptCost(input: ModelAttemptCostIdentity): boolean {
  return pricingForAttempt(input) !== undefined
}

export function estimateModelAttemptCostUsd(
  input: ModelAttemptCostIdentity,
  usage: ModelAttemptUsage | undefined
): number | undefined {
  if (!usage) return undefined
  return estimateProviderCostUsd(pricingForAttempt(input), {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens ?? 0,
    cacheCreation: usage.cacheWriteTokens ?? 0
  })
}

function pricingForAttempt(input: ModelAttemptCostIdentity) {
  const provider = input.providerId.trim() ? getProvider(input.providerId) : undefined
  const configured = providerPricingForModel(provider?.advancedConfig, input.model)
  if (configured) return configured
  if (input.protocol.startsWith('openai.')) return builtinOpenAiPricingForModel(input.model)
  return undefined
}
