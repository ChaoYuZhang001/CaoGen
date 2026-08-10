import type { ProviderAdvancedConfig } from '../../shared/types'
import type { ProviderCircuitBreakerSettings } from '../../shared/types'

export function mergeCcSwitchAdvancedConfig(
  current: ProviderAdvancedConfig | undefined,
  incoming: ProviderAdvancedConfig | undefined
): ProviderAdvancedConfig {
  const reliability = mergeReliability(current?.reliability, incoming?.reliability)
  return {
    schemaVersion: 1,
    ...(current ?? {}),
    ...(incoming ?? {}),
    endpoints: mergeEndpoints(current, incoming),
    modelProfiles: mergeModelProfiles(current, incoming),
    runtime: { ...(current?.runtime ?? {}), ...(incoming?.runtime ?? {}) },
    ...(reliability ? { reliability } : {}),
    metadata: { ...(current?.metadata ?? {}), ...(incoming?.metadata ?? {}) }
  }
}

function mergeEndpoints(current: ProviderAdvancedConfig | undefined, incoming: ProviderAdvancedConfig | undefined) {
  const endpoints = new Map((current?.endpoints ?? []).map((endpoint) => [endpoint.url.toLowerCase(), endpoint]))
  for (const endpoint of incoming?.endpoints ?? []) endpoints.set(endpoint.url.toLowerCase(), endpoint)
  return endpoints.size > 0 ? [...endpoints.values()] : undefined
}

function mergeModelProfiles(current: ProviderAdvancedConfig | undefined, incoming: ProviderAdvancedConfig | undefined) {
  const profiles = new Map((current?.modelProfiles ?? []).map((profile) => [profile.model.toLowerCase(), profile]))
  for (const profile of incoming?.modelProfiles ?? []) profiles.set(profile.model.toLowerCase(), profile)
  return profiles.size > 0 ? [...profiles.values()] : undefined
}

function mergeReliability(
  current: ProviderAdvancedConfig['reliability'],
  incoming: ProviderAdvancedConfig['reliability']
): ProviderAdvancedConfig['reliability'] {
  if (!current && !incoming) return undefined
  const circuitBreaker: ProviderCircuitBreakerSettings | undefined = current?.circuitBreaker || incoming?.circuitBreaker
    ? { ...(current?.circuitBreaker ?? {}), ...(incoming?.circuitBreaker ?? {}) } as ProviderCircuitBreakerSettings
    : undefined
  return {
    ...(current ?? {}),
    ...(incoming ?? {}),
    ...(circuitBreaker ? { circuitBreaker } : {})
  }
}
