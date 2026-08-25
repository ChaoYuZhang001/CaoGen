import type { SearchProviderAdapter, SearchProviderRequest } from './search-broker'

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
        return normalizeSearchAdapterResponse(await response.json() as Record<string, unknown>)
      } catch (error) {
        if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return { status: 'timeout', message: 'Search adapter timed out.' }
        return { status: 'provider_failure', message: 'Search adapter failed before a verified result was produced.' }
      }
    }
  }
}

function normalizeSearchAdapterResponse(body: Record<string, unknown>) {
  const status = typeof body.status === 'string' ? body.status as 'success' : undefined
  const raw = Array.isArray(body.results) ? body.results : Array.isArray(body.items) ? body.items : []
  const results = raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const value = item as Record<string, unknown>
    const url = typeof value.url === 'string' ? value.url : typeof value.link === 'string' ? value.link : ''
    if (!url.trim()) return []
    return [{ url, ...(typeof value.title === 'string' ? { title: value.title } : {}), ...(typeof value.summary === 'string' ? { summary: value.summary } : typeof value.snippet === 'string' ? { summary: value.snippet } : {}) }]
  })
  return { ...(status ? { status } : {}), results, ...(typeof body.message === 'string' ? { message: body.message } : {}) }
}
