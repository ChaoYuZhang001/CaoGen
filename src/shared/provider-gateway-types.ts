import type { ModelAttemptOutcome, ModelAttemptStatus, ModelAttemptUsage } from './model-attempt-types'

export const PROVIDER_GATEWAY_HOST = '127.0.0.1' as const
export const PROVIDER_GATEWAY_DEFAULT_PORT = 18457

export type ProviderGatewayRuntimeState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'blocked'
  | 'error'

export interface ProviderGatewayConfigView {
  enabled: boolean
  host: typeof PROVIDER_GATEWAY_HOST
  port: number
  tokenConfigured: boolean
  tokenStorage: 'encrypted' | 'session' | 'unavailable' | 'missing'
}

export interface ProviderGatewayStatusView extends ProviderGatewayConfigView {
  state: ProviderGatewayRuntimeState
  baseUrl: string
  googleBaseUrl: string
  activeRequests: number
  startedAt?: number
  lastErrorCode?: 'port_in_use' | 'credential_unavailable' | 'listener_error' | 'configuration_error'
  lastError?: string
}

export interface ProviderGatewayUpdateInput {
  enabled?: boolean
  port?: number
  regenerateToken?: boolean
}

export interface ProviderGatewayModelView {
  id: string
  providerId: string
  providerName: string
  model: string
  engine: 'openai' | 'gemini'
}

export interface ProviderGatewayUsageRecord {
  schemaVersion: 1
  id: string
  requestId?: string
  ordinal?: number
  failoverFromAttemptId?: string
  routeReason?: string
  providerId: string
  model: string
  keyLabel?: string
  protocol:
    | 'gateway.openai.chat-completions'
    | 'gateway.openai.responses'
    | 'gateway.anthropic.messages'
    | 'gateway.google.generative-language'
  status: ModelAttemptStatus
  outcome?: ModelAttemptOutcome
  startedAt: number
  completedAt: number
  latencyMs: number
  usage?: ModelAttemptUsage
  upstreamStatus?: number
}
