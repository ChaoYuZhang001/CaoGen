import type { ProviderPricingCatalogFetchResult } from '../../shared/types'
import {
  flattenModelsDevCatalog,
  matchModelsDevCatalog,
  MODELS_DEV_API_URL,
  MODELS_DEV_FETCH_TIMEOUT_MS
} from '../../shared/provider-pricing-catalog'

const MAX_CATALOG_BYTES = 24 * 1024 * 1024
const MAX_REQUESTED_MODELS = 500
const CACHE_TTL_MS = 60 * 60 * 1000

let cache: { fetchedAt: number; entries: ReturnType<typeof flattenModelsDevCatalog> } | undefined

export async function fetchProviderPricingCatalog(modelIds: string[]): Promise<ProviderPricingCatalogFetchResult> {
  const requestedModels = modelIds.slice(0, MAX_REQUESTED_MODELS).map((model) => model.trim()).filter(Boolean)
  const now = Date.now()
  if (!cache || now - cache.fetchedAt >= CACHE_TTL_MS) cache = await fetchCatalog(now)
  return {
    endpoint: MODELS_DEV_API_URL,
    fetchedAt: cache.fetchedAt,
    requested: requestedModels.length,
    matched: matchModelsDevCatalog(cache.entries, requestedModels)
  }
}

async function fetchCatalog(fetchedAt: number): Promise<NonNullable<typeof cache>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), MODELS_DEV_FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(MODELS_DEV_API_URL, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`)
    const declaredLength = Number(response.headers.get('content-length') ?? 0)
    if (declaredLength > MAX_CATALOG_BYTES) throw new Error('models.dev catalog is too large')
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_CATALOG_BYTES) throw new Error('models.dev catalog is too large')
    return { fetchedAt, entries: flattenModelsDevCatalog(JSON.parse(text) as unknown) }
  } finally {
    clearTimeout(timeout)
  }
}
