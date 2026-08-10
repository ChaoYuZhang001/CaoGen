import type {
  EngineKind,
  OpenAIProtocol,
  ProviderDiagnosticCredentialSource,
  ProviderDiagnosticGenerationProtocol,
  ProviderGenerationProbeInput,
  ProviderGenerationProbeOutcome,
  ProviderGenerationProbeResult,
  ProviderModelFailureReason,
  ProviderModelSuggestedAction
} from '../../shared/types'
import { inspectProviderBaseUrl } from '../providerCredentialBroker'
import { openAiEndpoint } from './openai-provider-utils'

export interface ProviderGenerationProbeCredentials {
  headers: Record<string, string>
  headerNames: string[]
  source: ProviderDiagnosticCredentialSource
  label?: string
  available: boolean
}

export async function executeProviderGenerationProbe(
  input: ProviderGenerationProbeInput,
  credentials: ProviderGenerationProbeCredentials,
  fetchImpl: typeof fetch = fetch
): Promise<ProviderGenerationProbeResult> {
  const startedAt = Date.now()
  const providerId = input.providerId?.trim() || undefined
  const engine = input.engine ?? 'openai'
  const protocol = generationProtocol(engine, input.openaiProtocol)
  const baseUrl = safeBaseUrl(input.baseUrl)
  const model = input.model.trim()
  if (!model) throw new Error('Generation probe requires a model')

  const request = generationRequest(baseUrl, model, protocol)
  const endpointPath = safeGenerationPath(request.url, protocol, model)
  if (!credentials.available) {
    return {
      ok: false,
      providerId,
      protocol,
      endpointPath,
      credentialSource: credentials.source,
      credentialLabel: credentials.label,
      credentialHeaderNames: credentials.headerNames,
      outcome: 'auth',
      reasonCode: 'credentials_missing',
      suggestedActions: ['enter_credentials'],
      latencyMs: Date.now() - startedAt,
      billableRequest: true
    }
  }
  let status: number | undefined
  let outcome: ProviderGenerationProbeOutcome
  try {
    const response = await fetchImpl(request.url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(protocol === 'anthropic-messages' ? { 'anthropic-version': '2023-06-01' } : {}),
        ...credentials.headers
      },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(20_000)
    })
    status = response.status
    outcome = classifyStatus(response.status)
    await response.body?.cancel().catch(() => undefined)
  } catch {
    outcome = 'network'
  }
  const diagnosis = diagnoseOutcome(outcome, status)

  return {
    ok: outcome === 'success',
    providerId,
    protocol,
    endpointPath,
    credentialSource: credentials.source,
    credentialLabel: credentials.label,
    credentialHeaderNames: credentials.headerNames,
    outcome,
    reasonCode: diagnosis.reasonCode,
    suggestedActions: diagnosis.suggestedActions,
    status,
    latencyMs: Date.now() - startedAt,
    billableRequest: true
  }
}

function safeBaseUrl(value: string): string {
  const inspected = inspectProviderBaseUrl(value.trim())
  if (!inspected.safeValue || inspected.rejectedNames.length > 0) {
    throw new Error('Provider generation target is invalid')
  }
  return inspected.safeValue.replace(/\/+$/, '')
}

function generationProtocol(engine: EngineKind, protocol: OpenAIProtocol | undefined): ProviderDiagnosticGenerationProtocol {
  if (engine === 'anthropic') return 'anthropic-messages'
  if (engine === 'gemini') return 'google-generative-language'
  return protocol === 'chat' ? 'openai-chat-completions' : 'openai-responses'
}

function generationRequest(
  baseUrl: string,
  model: string,
  protocol: ProviderDiagnosticGenerationProtocol
): { url: string; body: Record<string, unknown> } {
  if (protocol === 'anthropic-messages') {
    return {
      url: anthropicMessagesEndpoint(baseUrl),
      body: { model, max_tokens: 1, stream: false, messages: [{ role: 'user', content: 'OK' }] }
    }
  }
  if (protocol === 'google-generative-language') {
    return {
      url: googleGenerationEndpoint(baseUrl, model),
      body: {
        contents: [{ role: 'user', parts: [{ text: 'OK' }] }],
        generationConfig: { maxOutputTokens: 1 }
      }
    }
  }
  if (protocol === 'openai-chat-completions') {
    return {
      url: openAiEndpoint(baseUrl, 'chat/completions'),
      body: { model, max_tokens: 1, stream: false, messages: [{ role: 'user', content: 'OK' }] }
    }
  }
  return {
    url: openAiEndpoint(baseUrl, 'responses'),
    body: { model, max_output_tokens: 1, stream: false, input: 'OK' }
  }
}

function safeGenerationPath(
  requestUrl: string,
  protocol: ProviderDiagnosticGenerationProtocol,
  model: string
): string {
  const url = new URL(requestUrl)
  if (protocol !== 'google-generative-language') return url.pathname
  const encodedModel = encodeURIComponent(model.replace(/^models\//, ''))
  return url.pathname.replace(encodedModel, '{model}')
}

function diagnoseOutcome(
  outcome: ProviderGenerationProbeOutcome,
  status: number | undefined
): { reasonCode: ProviderModelFailureReason | 'none'; suggestedActions: ProviderModelSuggestedAction[] } {
  if (outcome === 'success') return { reasonCode: 'none', suggestedActions: [] }
  if (outcome === 'auth') {
    return {
      reasonCode: 'base_url_or_credentials_mismatch',
      suggestedActions: ['review_credentials', 'review_base_url_and_credentials', 'review_protocol']
    }
  }
  if (outcome === 'not_found') {
    return {
      reasonCode: 'base_url_invalid',
      suggestedActions: ['review_base_url_and_credentials', 'review_protocol']
    }
  }
  if (outcome === 'rate_limit') return { reasonCode: 'rate_limited', suggestedActions: ['retry_later'] }
  if (outcome === 'server') return { reasonCode: 'provider_unavailable', suggestedActions: ['retry_later'] }
  if (outcome === 'network') return { reasonCode: 'network_unavailable', suggestedActions: ['check_network'] }
  return {
    reasonCode: status === 400 || status === 422 ? 'unknown' : 'base_url_invalid',
    suggestedActions: ['review_model', 'review_protocol', 'review_configuration']
  }
}

function googleGenerationEndpoint(baseUrl: string, model: string): string {
  const url = new URL(baseUrl)
  let path = url.pathname.replace(/\/+$/, '')
  if (!/\/v1(?:beta)?$/i.test(path)) path = `${path}/v1beta`
  url.pathname = `${path}/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`
  return url.toString().replace(/\/$/, '')
}

function anthropicMessagesEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl)
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = /\/v1\/messages$/i.test(path)
    ? path
    : /\/v1$/i.test(path) ? `${path}/messages` : `${path}/v1/messages`.replace(/^\/\//, '/')
  return url.toString().replace(/\/$/, '')
}

function classifyStatus(status: number): ProviderGenerationProbeOutcome {
  if (status >= 200 && status < 300) return 'success'
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limit'
  if (status >= 500) return 'server'
  return 'invalid_request'
}
