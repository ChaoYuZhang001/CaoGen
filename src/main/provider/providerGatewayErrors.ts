import type { ProviderGatewayUsageRecord } from '../../shared/provider-gateway-types'
import { AnthropicOpenAiGatewayError } from './anthropicOpenAiGateway'

const SWITCHABLE_UPSTREAM_STATUSES = new Set([401, 403, 429, 500, 502, 503, 504, 529])

export class GatewayHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

export function gatewayHttpError(status: number, code: string, message: string): GatewayHttpError {
  return new GatewayHttpError(status, code, message)
}

export function publicGatewayError(
  error: unknown,
  signal: AbortSignal
): { status: number; code: string; message: string } {
  if (error instanceof GatewayHttpError || error instanceof AnthropicOpenAiGatewayError) return error
  if (providerTimeoutCode(error)) return { status: 504, code: 'provider_timeout', message: 'Provider request timed out' }
  if (signal.aborted) {
    return signal.reason instanceof Error && signal.reason.message === 'provider_timeout'
      ? { status: 504, code: 'provider_timeout', message: 'Provider request timed out' }
      : { status: 499, code: 'client_closed_request', message: 'Client disconnected' }
  }
  return { status: 502, code: 'provider_unavailable', message: 'Provider request failed' }
}

export function gatewayErrorEnvelope(
  code: string,
  message: string,
  protocol?: ProviderGatewayUsageRecord['protocol'],
  status?: number
): Record<string, unknown> {
  if (protocol === 'gateway.anthropic.messages') {
    return { type: 'error', error: { type: anthropicErrorType(code, status), message } }
  }
  if (protocol === 'gateway.google.generative-language') {
    return { error: { code: status ?? googleErrorHttpStatus(code), message, status: googleErrorStatus(code, status) } }
  }
  return { error: { message, type: 'invalid_request_error', code } }
}

export function gatewayErrorOutcome(
  error: unknown,
  signal: AbortSignal
): ProviderGatewayUsageRecord['outcome'] {
  if (signal.aborted && signal.reason instanceof Error && signal.reason.message === 'provider_timeout') return 'timeout'
  if (providerTimeoutCode(error)) return 'timeout'
  if (error instanceof GatewayHttpError) return outcomeForStatus(error.status)
  return 'unavailable'
}

export function boundedGatewayProviderFailure(
  error: unknown,
  signal: AbortSignal,
  upstreamStatus?: number
): string {
  if (upstreamStatus !== undefined) return `Provider HTTP ${upstreamStatus}`
  if (signal.aborted && signal.reason instanceof Error && signal.reason.message === 'provider_timeout') {
    return 'Provider request timeout'
  }
  if (providerTimeoutCode(error)) return 'Provider request timeout'
  if (error instanceof GatewayHttpError) return `Provider gateway ${error.code}`
  return 'Provider network unavailable'
}

export function switchableGatewayFailure(error: unknown, signal: AbortSignal): boolean {
  if (gatewayClientDisconnected(signal)) return false
  if (signal.aborted && signal.reason instanceof Error && signal.reason.message === 'provider_timeout') return false
  if (providerTimeoutCode(error)) return true
  if (error instanceof GatewayHttpError) {
    if (error.code === 'provider_redirect_rejected') return false
    if (error.code === 'provider_circuit_open' || error.code === 'provider_credential_unavailable') return true
    return SWITCHABLE_UPSTREAM_STATUSES.has(error.status)
  }
  if (error instanceof AnthropicOpenAiGatewayError) return SWITCHABLE_UPSTREAM_STATUSES.has(error.status)
  return true
}

export function publicGatewayFailureLabel(error: unknown, signal: AbortSignal): string {
  if (providerTimeoutCode(error)) return 'Provider timeout'
  if (error instanceof GatewayHttpError) {
    if (error.status === 429) return 'Provider rate limit'
    if (error.status === 401 || error.status === 403) return 'Provider authorization failure'
    if (error.status >= 500) return 'Provider service unavailable'
  }
  if (signal.aborted) return 'Provider timeout'
  return 'Provider network failure'
}

export function gatewayClientDisconnected(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof Error && signal.reason.message === 'client_disconnected'
}

function providerTimeoutCode(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error
    && typeof error.code === 'string' && error.code.startsWith('PROVIDER_') && error.code.endsWith('_TIMEOUT'))
}

function outcomeForStatus(status: number): ProviderGatewayUsageRecord['outcome'] {
  if (status === 401 || status === 403) return 'auth_failed'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'unavailable'
  return 'error'
}

function anthropicErrorType(code: string, status?: number): string {
  if (code === 'invalid_api_key') return 'authentication_error'
  if (code === 'gateway_busy' || status === 429) return 'rate_limit_error'
  if (code === 'provider_unavailable') return 'api_error'
  return 'invalid_request_error'
}

function googleErrorHttpStatus(code: string): number {
  if (code === 'invalid_api_key') return 401
  if (code === 'not_found' || code === 'model_not_found') return 404
  if (code === 'model_ambiguous') return 409
  if (code === 'gateway_busy') return 429
  if (code === 'provider_timeout') return 504
  if (code === 'provider_unavailable' || code === 'provider_error') return 503
  return 400
}

function googleErrorStatus(code: string, status?: number): string {
  if (code === 'invalid_api_key') return 'UNAUTHENTICATED'
  if (code === 'not_found' || code === 'model_not_found') return 'NOT_FOUND'
  if (code === 'model_ambiguous') return 'FAILED_PRECONDITION'
  if (code === 'gateway_busy' || status === 429) return 'RESOURCE_EXHAUSTED'
  if (code === 'provider_timeout') return 'DEADLINE_EXCEEDED'
  if (code === 'provider_unavailable' || code === 'provider_error') return 'UNAVAILABLE'
  return 'INVALID_ARGUMENT'
}
