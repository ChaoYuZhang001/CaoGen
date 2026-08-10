import type { Provider, ProviderRuntimeConfig } from '../../shared/types'

const PROTECTED_BODY_FIELDS = new Set([
  'model',
  'input',
  'messages',
  'tools',
  'tool_choice',
  'max_tokens',
  'stream',
  'stream_options',
  'previous_response_id',
  'instructions',
  'system'
])

type ProviderRequestProvider = Pick<Provider, 'baseUrl' | 'advancedConfig'>

export interface AppliedProviderRequest<T extends Record<string, unknown>> {
  url: string
  headers: Record<string, string>
  body: T
}

/** Apply only the non-secret, normalized Provider request extension. */
export function applyProviderRequestOverrides<T extends Record<string, unknown>>(
  provider: ProviderRequestProvider | undefined,
  url: string,
  body: T,
  headers: Record<string, string> = {}
): AppliedProviderRequest<T> {
  const request = provider?.advancedConfig?.request
  const nextHeaders = { ...headers, ...(request?.headers ?? {}) }
  const nextUrl = appendProviderRequestQuery(url, provider?.baseUrl, request?.query)
  const nextBody = applyProviderRuntimeConfig(
    mergeProviderRequestBody(body, request?.body),
    provider?.advancedConfig?.runtime
  ) as T
  return { url: nextUrl, headers: nextHeaders, body: nextBody }
}

export function applyProviderRuntimeConfig(
  body: Record<string, unknown>,
  runtime: ProviderRuntimeConfig | undefined
): Record<string, unknown> {
  const result = cloneValue(body) as Record<string, unknown>
  if (!runtime) return result
  const responsesProtocol = Object.prototype.hasOwnProperty.call(result, 'input')
  if (runtime.reasoningEffort !== undefined) {
    if (responsesProtocol) {
      result.reasoning = { ...(isRecord(result.reasoning) ? result.reasoning : {}), effort: runtime.reasoningEffort }
    } else {
      result.reasoning_effort = runtime.reasoningEffort
    }
  }
  if (runtime.verbosity !== undefined) {
    if (responsesProtocol) {
      result.text = { ...(isRecord(result.text) ? result.text : {}), verbosity: runtime.verbosity }
    } else {
      result.verbosity = runtime.verbosity
    }
  }
  if (runtime.temperature !== undefined) result.temperature = runtime.temperature
  if (runtime.topP !== undefined) result.top_p = runtime.topP
  if (runtime.maxOutputTokens !== undefined) {
    result[responsesProtocol ? 'max_output_tokens' : 'max_tokens'] = runtime.maxOutputTokens
  }
  if (runtime.parallelToolCalls !== undefined) result.parallel_tool_calls = runtime.parallelToolCalls
  if (runtime.storeResponses !== undefined) result.store = runtime.storeResponses
  if (runtime.serviceTier !== undefined) result.service_tier = runtime.serviceTier
  return result
}

export function appendProviderRequestQuery(
  url: string,
  providerBaseUrl: string | undefined,
  query: Record<string, string> | undefined
): string {
  if (!query || Object.keys(query).length === 0) return url
  try {
    const target = new URL(url)
    if (providerBaseUrl) {
      const base = new URL(providerBaseUrl)
      if (target.origin !== base.origin) return url
    }
    for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value)
    return target.toString()
  } catch {
    return url
  }
}

export function mergeProviderRequestBody(
  body: Record<string, unknown>,
  overrides: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!overrides) return { ...body }
  const result: Record<string, unknown> = { ...body }
  for (const [key, value] of Object.entries(overrides)) {
    if (PROTECTED_BODY_FIELDS.has(key)) continue
    const current = result[key]
    if (isRecord(current) && isRecord(value)) {
      result[key] = mergeProviderRequestBody(current, value)
    } else {
      result[key] = cloneValue(value)
    }
  }
  return result
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]))
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
