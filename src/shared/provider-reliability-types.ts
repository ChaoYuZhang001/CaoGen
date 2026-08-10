import type { ProviderCircuitBreakerSettings } from './types'

/** Provider-specific recovery controls. Missing values inherit the global recovery settings. */
export interface ProviderReliabilityConfig {
  failoverEnabled?: boolean
  maxRetries?: number
  streamingFirstByteTimeoutSeconds?: number
  streamingIdleTimeoutSeconds?: number
  requestTimeoutSeconds?: number
  circuitBreaker?: ProviderCircuitBreakerSettings
}
