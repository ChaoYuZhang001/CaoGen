import type { SearchProviderAdapter, SearchProviderRequest, SearchProviderResponse } from './search-broker'

export function configuredSearchAdapter(urlEnv: string, keyEnv: string): SearchProviderAdapter | undefined {
  const endpoint = process.env[urlEnv]?.trim()
  if (!endpoint) return undefined
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return { available: false, async search() { return { status: 'provider_failure', message: `Invalid search endpoint in ${urlEnv}.` } } }
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    return { available: false, async search() { return { status: 'egress_denied', message: `Search endpoint in ${urlEnv} must be a credential-free HTTP(S) URL.` } } }
  }
  return {
    available: () => keyEnv === 'CAOGEN_SEARCH_MODEL_NATIVE_API_KEY' || Boolean(process.env[keyEnv]?.trim()),
    async search(input: SearchProviderRequest) {
      const key = process.env[keyEnv]?.trim()
      if (!key && keyEnv !== 'CAOGEN_SEARCH_MODEL_NATIVE_API_KEY') return { status: 'no_credentials', message: 'No BYOK search credentials are configured.' }
      try {
        const response = await fetch(url, {
          method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({ query: input.query, limit: input.limit, operationId: input.operationId, mode: input.mode }), signal: input.signal
        })
        if (!response.ok) return { status: 'provider_failure', message: `Search adapter returned HTTP ${response.status}.` }
        const body: unknown = await response.json()
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return { status: 'unknown_result', results: [], message: 'Search adapter returned a non-object response.' }
        }
        return normalizeSearchAdapterResponse(body as Record<string, unknown>)
      } catch (error) {
        if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return { status: 'timeout', message: 'Search adapter timed out.' }
        return { status: 'provider_failure', message: 'Search adapter failed before a verified result was produced.' }
      }
    }
  }
}

function normalizeSearchAdapterResponse(body: Record<string, unknown>) {
  const status = normalizeAdapterStatus(body.status)
  if (status === 'invalid') return adapterFailure('unknown_result', 'Search adapter returned an unknown status.')
  if (status && status !== 'success') return adapterFailure(status, body.message)
  const raw = adapterItems(body)
  if (!raw) return adapterFailure('unknown_result', 'Search adapter response omitted results.')
  const results = normalizeAdapterItems(raw)
  if (!results) return adapterFailure('unknown_result', 'Search adapter returned an unverified result.')
  return { ...(status ? { status } : {}), results, ...(typeof body.message === 'string' ? { message: body.message } : {}) }
}

type NormalizedAdapterItem = { url: string; title?: string; summary?: string }

function normalizeAdapterStatus(value: unknown): SearchProviderResponse['status'] | 'invalid' | undefined {
  if (value === undefined) return undefined
  return isSearchStatus(value) ? value : 'invalid'
}

function isSearchStatus(value: unknown): value is NonNullable<SearchProviderResponse['status']> {
  return ['success', 'no_results', 'timeout', 'no_credentials', 'egress_denied', 'provider_failure', 'unknown_result'].includes(String(value))
}

function adapterItems(body: Record<string, unknown>): unknown[] | undefined {
  if (Array.isArray(body.results)) return body.results
  if (Array.isArray(body.items)) return body.items
  return undefined
}

function normalizeAdapterItems(raw: readonly unknown[]): NormalizedAdapterItem[] | undefined {
  const results: NormalizedAdapterItem[] = []
  for (const item of raw) {
    const normalized = normalizeAdapterItem(item)
    if (!normalized) return undefined
    results.push(normalized)
  }
  return results
}

function normalizeAdapterItem(item: unknown): NormalizedAdapterItem | undefined {
  if (!item || typeof item !== 'object') return undefined
  const value = item as Record<string, unknown>
  const url = typeof value.url === 'string' ? value.url : typeof value.link === 'string' ? value.link : ''
  if (!url.trim()) return undefined
  return {
    url,
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(typeof value.summary === 'string' ? { summary: value.summary } : typeof value.snippet === 'string' ? { summary: value.snippet } : {})
  }
}

function adapterFailure(status: NonNullable<SearchProviderResponse['status']>, message: unknown) {
  return {
    status,
    results: [],
    ...(typeof message === 'string' ? { message } : {})
  }
}
