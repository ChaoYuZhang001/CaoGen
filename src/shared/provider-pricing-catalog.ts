import type {
  ProviderModelPricing,
  ProviderModelProfile,
  ProviderPricingCatalogEntry
} from './types'

export const MODELS_DEV_API_URL = 'https://models.dev/api.json' as const
export const MODELS_DEV_FETCH_TIMEOUT_MS = 15_000

const NON_TEXT_MODEL_MARKERS = [
  'audio', 'deprecated', 'embedding', 'image', 'moderation', 'realtime',
  'transcribe', 'tts', 'video'
]
const NON_TEXT_OUTPUT_MODALITIES = new Set(['audio', 'image', 'video'])

export function normalizeModelIdForPricing(modelId: string): string {
  const afterSlash = modelId.slice(modelId.lastIndexOf('/') + 1)
  const beforeColon = afterSlash.split(':')[0] ?? ''
  let normalized = beforeColon.trim().replace(/@/g, '-').toLowerCase()
  if (normalized.endsWith('[1m]')) normalized = normalized.slice(0, -'[1m]'.length).trim()
  return normalized
}

export function flattenModelsDevCatalog(data: unknown): ProviderPricingCatalogEntry[] {
  if (!isRecord(data)) throw new Error('models.dev catalog must be an object')
  const entries: ProviderPricingCatalogEntry[] = []
  for (const [providerId, providerValue] of Object.entries(data)) {
    if (!isRecord(providerValue)) continue
    const providerName = text(providerValue.name) || providerId
    if (!isRecord(providerValue.models)) continue
    for (const [modelId, modelValue] of Object.entries(providerValue.models)) {
      if (!isRecord(modelValue) || !isTextPricingModel(modelId, modelValue)) continue
      const cost = isRecord(modelValue.cost) ? modelValue.cost : undefined
      const input = finiteNonNegative(cost?.input)
      const output = finiteNonNegative(cost?.output)
      if (input === undefined && output === undefined) continue
      const normalizedId = normalizeModelIdForPricing(modelId)
      if (!normalizedId) continue
      entries.push({
        key: `${providerId}/${modelId}`,
        providerId,
        providerName,
        modelId,
        normalizedId,
        modelName: text(modelValue.name) || modelId,
        releaseDate: text(modelValue.release_date) || undefined,
        pricing: {
          currency: 'USD',
          inputPerMillion: input ?? 0,
          outputPerMillion: output ?? 0,
          cacheReadPerMillion: finiteNonNegative(cost?.cache_read),
          cacheWritePerMillion: finiteNonNegative(cost?.cache_write),
          source: 'catalog'
        }
      })
    }
  }
  return entries.sort((left, right) =>
    (right.releaseDate ?? '').localeCompare(left.releaseDate ?? '')
      || left.modelName.localeCompare(right.modelName)
  )
}

export function matchModelsDevCatalog(
  entries: ProviderPricingCatalogEntry[],
  modelIds: string[]
): ProviderPricingCatalogEntry[] {
  const matches: ProviderPricingCatalogEntry[] = []
  const seen = new Set<string>()
  for (const rawModel of modelIds) {
    const model = rawModel.trim()
    const normalized = normalizeModelIdForPricing(model)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    const exact = entries.find((entry) => entry.modelId.toLowerCase() === model.toLowerCase())
    const normalizedMatch = entries.find((entry) => entry.normalizedId === normalized)
    const match = exact ?? normalizedMatch
    if (match) matches.push(match)
  }
  return matches
}

export function syncDiscoveredModelProfiles(
  profiles: ProviderModelProfile[],
  modelIds: string[]
): { profiles: ProviderModelProfile[]; added: number } {
  const next = [...profiles]
  const known = new Set(next.flatMap((profile) => [profile.model, ...(profile.aliases ?? [])])
    .map((model) => model.trim().toLowerCase()).filter(Boolean))
  let added = 0
  for (const rawModel of modelIds) {
    const model = rawModel.trim()
    const key = model.toLowerCase()
    if (!model || known.has(key)) continue
    next.push({ model })
    known.add(key)
    added += 1
  }
  return { profiles: next, added }
}

export function mergeCatalogPricing(
  profiles: ProviderModelProfile[],
  entries: ProviderPricingCatalogEntry[],
  updatedAt = Date.now()
): { profiles: ProviderModelProfile[]; imported: number; protectedUserPrices: number } {
  let imported = 0
  let protectedUserPrices = 0
  const next = profiles.map((profile) => {
    const candidates = [profile.model, ...(profile.aliases ?? [])]
    const match = matchModelsDevCatalog(entries, candidates)[0]
    if (!match) return profile
    if (profile.pricing?.source === 'user') {
      protectedUserPrices += 1
      return profile
    }
    imported += 1
    return {
      ...profile,
      displayName: profile.displayName || match.modelName,
      pricing: { ...match.pricing, updatedAt }
    }
  })
  return { profiles: next, imported, protectedUserPrices }
}

function isTextPricingModel(modelId: string, model: Record<string, unknown>): boolean {
  if (text(model.status).toLowerCase() === 'deprecated') return false
  const output = isRecord(model.modalities) && Array.isArray(model.modalities.output)
    ? model.modalities.output.filter((item): item is string => typeof item === 'string').map((item) => item.toLowerCase())
    : []
  if (output.length > 0 && (!output.includes('text') || output.some((item) => NON_TEXT_OUTPUT_MODALITIES.has(item)))) {
    return false
  }
  const searchable = `${modelId} ${text(model.name)}`.toLowerCase()
  return !NON_TEXT_MODEL_MARKERS.some((marker) => searchable.includes(marker))
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
